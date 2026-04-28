import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { AppMode, FileMetadata, ProcessingProgress, EncoderResult, ArchiveInspection, OperationControlOptions, HDARecipientInput } from "./types";
import { decodeFromHDA } from "./services/hdaDecoder";
import { generateHDA } from "./services/hdaEncoder";
import { inspectHDA, verifyHDA } from "./services/hdaInspector";
import {
  UploadCloud,
  RefreshCcw,
  AlertCircle,
  Layers,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  ShieldAlert,
  Sparkles,
  Terminal,
  Hexagon,
  Cpu,
  FolderOpen,
  ShieldCheck,
  ListChecks,
} from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { cn, formatBytes } from "./lib/utils";
import { clearCheckpoint, getCheckpoint, listCheckpoints } from "./services/resumeStore";
import { assessPasswordStrength, mapProtocolError, secureDeleteGuidance } from "./lib/securityUi";
import { getSecurityEvents } from "./lib/securityEvents";
import { logSecurityEvent } from "./lib/securityEvents";
import { getPlatformCapabilities } from "./lib/platform";
import { captureError, getDiagnosticsOptIn, setDiagnosticsOptIn } from "./lib/telemetry";

declare const __APP_BUILD_METADATA__: {
  version: string;
  protocol: string;
  commit: string;
  buildTime: string;
};

const BUILD_METADATA =
  typeof __APP_BUILD_METADATA__ !== "undefined"
    ? __APP_BUILD_METADATA__
    : {
        version: "0.0.0",
        protocol: "4.0",
        commit: "dev",
        buildTime: new Date(0).toISOString(),
      };

// ─── Error Boundary ───────────────────────────────────────────────
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    captureError(error, "react.error_boundary");
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 p-8">
          <div className="bg-red-500/10 border border-red-500/20 rounded-3xl p-8 max-w-md text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-red-500 uppercase tracking-tighter mb-2">
              System Crash
            </h2>
            <p className="text-slate-400 text-sm mb-4">
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-indigo-600 text-white font-bold py-3 px-6 rounded-xl hover:bg-indigo-500 transition-colors uppercase text-sm tracking-widest"
            >
              Force System Reboot
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// ─── Main App Component ───────────────────────────────────────────
const AppContent: React.FC = () => {
  const reduceMotion = useReducedMotion();
  const [mode, setMode] = useState<AppMode>(AppMode.ENCODE);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeJob, setResumeJob] = useState<{
    file: File;
    mode: AppMode;
    password: string | null;
    options?: OperationControlOptions;
  } | null>(null);
  const [persistedResume, setPersistedResume] = useState<{
    resumeKey: string;
    fileName: string;
    mode: AppMode;
    hasSourceFileHandle: boolean;
  } | null>(null);
  const [inspection, setInspection] = useState<{
    file: File;
    companions: File[];
    details: ArchiveInspection;
  } | null>(null);
  const [batchResults, setBatchResults] = useState<Array<{ blob: Blob; metadata: FileMetadata }>>([]);
  const [jobQueue, setJobQueue] = useState<Array<{
    file: File;
    companions?: File[];
    options?: OperationControlOptions;
  }>>([]);
  const [securityFeed, setSecurityFeed] = useState<string[]>([]);
  const [result, setResult] = useState<{
    blob: Blob;
    metadata: FileMetadata;
  } | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isEncryptedVolume, setIsEncryptedVolume] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingOptions, setPendingOptions] = useState<OperationControlOptions>({});
  const terminalRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [useArgon2id, setUseArgon2id] = useState(false);
  const [passwordHint, setPasswordHint] = useState("");
  const [archiveComment, setArchiveComment] = useState("");
  const [archiveTags, setArchiveTags] = useState("");
  const [recipientDraft, setRecipientDraft] = useState("");
  const [inspectionSearch, setInspectionSearch] = useState("");
  const [diagnosticsOptIn, setDiagnosticsOptInState] = useState(getDiagnosticsOptIn());
  const [integrityOnly, setIntegrityOnly] = useState(false);
  const passwordAssessment = assessPasswordStrength(password);
  const platform = getPlatformCapabilities();
  const recipients = useMemo<HDARecipientInput[]>(
    () =>
      recipientDraft
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(":");
          if (separator === -1) {
            return null;
          }
          return {
            label: line.slice(0, separator).trim(),
            password: line.slice(separator + 1).trim(),
            preferredKdf: useArgon2id ? "Argon2id" : "PBKDF2-SHA256",
          } satisfies HDARecipientInput;
        })
        .filter((value) => !!value && !!value.label && !!value.password) as HDARecipientInput[],
    [recipientDraft, useArgon2id],
  );
  const filteredFolderEntries = useMemo(
    () =>
      inspection?.details.folderManifest?.entries.filter((entry) =>
        !inspectionSearch.trim()
          ? true
          : entry.relativePath.toLowerCase().includes(inspectionSearch.toLowerCase()),
      ) ?? [],
    [inspection, inspectionSearch],
  );

  const refreshSecurityFeed = useCallback(() => {
    setSecurityFeed(
      getSecurityEvents()
        .slice(-5)
        .map((event) => `${event.code}: ${event.message}`),
    );
  }, []);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [progress?.logs]);

  useEffect(() => {
    if (password && passwordAssessment.label === "Weak") {
      logSecurityEvent({
        code: "weak_password",
        message: "Weak password entered in UI.",
      });
      refreshSecurityFeed();
    }
  }, [password, passwordAssessment.label, refreshSecurityFeed]);

  useEffect(() => {
    setDiagnosticsOptIn(diagnosticsOptIn);
  }, [diagnosticsOptIn]);

  useEffect(() => {
    let active = true;

    void listCheckpoints().then((entries) => {
      if (!active) return;
      const latest = entries[0];
      setPersistedResume(
        latest
          ? {
              resumeKey: latest.resumeKey,
              fileName: latest.fileName,
              mode: latest.mode === AppMode.ENCODE ? AppMode.ENCODE : AppMode.DECODE,
              hasSourceFileHandle: latest.hasSourceFileHandle,
            }
          : null,
      );
    });

    return () => {
      active = false;
    };
  }, []);

  const processFile = async (
    file: File,
    pass: string | null = null,
    controlOptions: OperationControlOptions = {},
  ) => {
    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setProgress({
      percentage: 0,
      status: "Initializing...",
      logs: ["[CORE] Cold Boot Ready"],
      stage: "initializing",
    });
    setError(null);
    setResult(null);
    setResumeJob(null);
    setInspection(null);

    try {
      if (mode === AppMode.ENCODE) {
        const resultData = await generateHDA(file, pass, (p) =>
          setProgress(p),
          {
            ...controlOptions,
            signal: abortController.signal,
            preferredKdf: useArgon2id ? "Argon2id" : "PBKDF2-SHA256",
            passwordHint: passwordHint || null,
            archiveComment: archiveComment || null,
            archiveTags: archiveTags.split(",").map((tag) => tag.trim()).filter(Boolean),
            integrityOnly,
            recipients,
          },
        );
        if (!resultData) {
          setProgress(null);
          return;
        }
        const encoderResult = resultData as EncoderResult;
        const nextResult = {
          blob: encoderResult.blob || new Blob(),
          metadata: resultData,
        };
        setResult(nextResult);
        setBatchResults((current) => [...current, nextResult]);
      } else {
        try {
          const decoded = await decodeFromHDA(file, pass, (p) =>
            setProgress(p),
            { ...controlOptions, signal: abortController.signal },
          );
          if (!decoded) {
            setProgress(null);
            return;
          }
          setResult(decoded);
          setBatchResults((current) => [...current, decoded]);
          setIsEncryptedVolume(false);
        } catch (err: unknown) {
          const error = err as Error;
          if (error.message === "ENCRYPTED_VOLUME") {
            setIsEncryptedVolume(true);
            setPendingFile(file);
            setPendingOptions(controlOptions);
            setProgress(null);
          } else {
            throw err;
          }
        }
      }
    } catch (err: unknown) {
      const error = err as Error;
      if (
        error.name === "AbortError" ||
        error.message === "Operation cancelled."
      ) {
        setResumeJob({ file, mode, password: pass, options: controlOptions });
        setError(null);
      } else {
        setError(mapProtocolError(error.message || "System error encountered."));
        captureError(error, "app.processFile");
        refreshSecurityFeed();
      }
    } finally {
      setProgress(null);
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
    }
  };

  const buildDecodeJobs = (files: File[]) => {
    const splitGroups = new Map<string, File[]>();
    const singles: Array<{ file: File; companions?: File[] }> = [];

    for (const file of files) {
      const splitBase = file.name.match(/^(.*)\.part\d+\.hda$/i)?.[1];
      if (splitBase) {
        const key = `${splitBase}:${file.lastModified}`;
        const group = splitGroups.get(key) ?? [];
        group.push(file);
        splitGroups.set(key, group);
      } else {
        singles.push({ file });
      }
    }

    for (const group of splitGroups.values()) {
      const ordered = group.sort((left, right) => left.name.localeCompare(right.name));
      const [primary, ...companions] = ordered;
      singles.push({ file: primary, companions });
    }

    return singles;
  };

  const buildFolderManifest = (files: File[]) => {
    const folderEntries = files
      .map((file) => {
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        if (!relativePath) {
          return null;
        }
        return {
          relativePath,
          size: file.size,
          type: file.type || undefined,
        };
      })
      .filter((entry) => !!entry) as Array<{ relativePath: string; size: number; type?: string }>;

    if (!folderEntries.length) {
      return null;
    }

    const rootPath = folderEntries[0].relativePath.split("/")[0] || "folder";
    return {
      rootPath,
      entries: folderEntries,
    };
  };

  const processFiles = async (
    files: FileList | File[],
    pass: string | null = null,
    sourceHandles: Array<FileSystemFileHandle | null> = [],
  ) => {
    const list = Array.from(files);
    if (!list.length) return;
    const folderManifest = buildFolderManifest(list);

    if (mode === AppMode.DECODE) {
      const jobs = buildDecodeJobs(list);
      if (jobs.length === 1) {
        const single = jobs[0];
        try {
          const inspected = await inspectHDA(single.file, { companionFiles: single.companions });
          setInspection({
            file: single.file,
            companions: single.companions ?? [],
            details: inspected.inspection,
          });
          return;
        } catch {
          await processFile(single.file, pass, { companionFiles: single.companions, sourceFileHandle: sourceHandles[0] ?? null });
          return;
        }
      }

      setJobQueue(jobs.map((job) => ({ file: job.file, companions: job.companions })));
      for (const [index, job] of jobs.entries()) {
        await processFile(job.file, pass, {
          companionFiles: job.companions,
          sourceFileHandle: sourceHandles[index] ?? null,
        });
      }
      setJobQueue([]);
      return;
    }

    setJobQueue(list.map((file, index) => ({ file, options: { sourceFileHandle: sourceHandles[index] ?? null, folderMetadata: folderManifest } })));
    for (const [index, nextFile] of list.entries()) {
      await processFile(nextFile, pass, { sourceFileHandle: sourceHandles[index] ?? null, folderMetadata: folderManifest });
    }
    setJobQueue([]);
  };

  const handleDownload = (target = result) => {
    if (!target || !target.blob || target.blob.size === 0) return;
    const maybeVolumes = (target.metadata as FileMetadata & { volumes?: EncoderResult["volumes"] }).volumes;
    if (maybeVolumes?.length) {
      for (const volume of maybeVolumes) {
        const url = URL.createObjectURL(volume.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = volume.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      return;
    }
    const url = URL.createObjectURL(target.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download =
      mode === AppMode.ENCODE
        ? `${target.metadata.name}.hda.html`
        : target.metadata.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const reset = () => {
    abortControllerRef.current?.abort();
    setResult(null);
    setError(null);
    setProgress(null);
    setResumeJob(null);
    setBatchResults([]);
    setPassword("");
    setIsEncryptedVolume(false);
    setPendingFile(null);
    setPendingOptions({});
    setIsDragging(false);
    setPersistedResume(null);
    setInspection(null);
    setSecurityFeed([]);
    setJobQueue([]);
    setPasswordHint("");
    setArchiveComment("");
    setArchiveTags("");
    setRecipientDraft("");
    setInspectionSearch("");
    setIntegrityOnly(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  };

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files, password || null);
      }
    },
    [password, mode],
  );

  const openWithFileAccess = async () => {
    if (!("showOpenFilePicker" in window)) {
      setError("This browser does not support persistent source handles.");
      return;
    }
    try {
      const handles = await (window as Window & {
        showOpenFilePicker: (options?: Record<string, unknown>) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker({
        multiple: true,
      });
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      await processFiles(files, password || null, handles);
    } catch (err) {
      const error = err as Error;
      if (error.name !== "AbortError") {
        setError(mapProtocolError(error.message));
      }
    }
  };

  const verifyInspectedArchive = async () => {
    if (!inspection) return;
    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setProgress({
      percentage: 0,
      status: "Validating archive...",
      logs: ["[VERIFY] Quick integrity pass armed"],
      stage: "initializing",
    });
    setError(null);
    try {
      await verifyHDA(inspection.file, password || null, (p) => setProgress(p), {
        signal: abortController.signal,
        companionFiles: inspection.companions,
      });
      setResult({
        blob: new Blob(),
        metadata: {
          name: inspection.details.filename,
          type: inspection.details.mimeType,
          size: inspection.details.totalBytes,
          timestamp: Date.now(),
          isEncrypted: !!inspection.details.encryption,
        },
      });
    } catch (err) {
      const error = err as Error;
      setError(mapProtocolError(error.message));
      refreshSecurityFeed();
    } finally {
      setProgress(null);
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 md:p-8 honeycomb">
      <header className="w-full max-w-4xl flex flex-col md:flex-row justify-between items-center mb-8 md:mb-16 gap-6 md:gap-8">
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="absolute inset-0 bg-indigo-500 blur-xl opacity-50 rounded-full"></div>
            <div className="relative bg-indigo-600 p-2 md:p-3 rounded-2xl shadow-xl transform -rotate-6 transition-transform hover:rotate-0">
              <Hexagon className="w-6 h-6 md:w-8 md:h-8 text-white" />
            </div>
          </div>
          <div>
            <h1 className="text-2xl md:text-4xl font-black tracking-tighter serif text-white uppercase">
              HDA<span className="text-indigo-400">Vault</span>
            </h1>
            <p className="text-slate-500 font-mono text-[8px] md:text-[10px] tracking-[0.3em] uppercase">
              Protocol v4.0 • Elite Forge
            </p>
          </div>
        </div>

        <nav className="flex w-full md:w-auto bg-slate-900/80 p-1 md:p-1.5 rounded-xl md:rounded-2xl border border-slate-800 backdrop-blur-md relative">
          <button
            onClick={() => {
              setMode(AppMode.ENCODE);
              reset();
            }}
            className={cn(
              "flex-1 md:flex-none relative px-4 md:px-8 py-2 md:py-2.5 rounded-lg md:rounded-xl text-xs md:text-sm font-bold transition-all z-10",
              mode === AppMode.ENCODE
                ? "text-white"
                : "text-slate-500 hover:text-white",
            )}
          >
            {mode === AppMode.ENCODE && (
              <motion.div
                layoutId="active-tab"
                className="absolute inset-0 bg-indigo-600 rounded-lg md:rounded-xl shadow-lg -z-10"
                transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
              />
            )}
            CREATE HIVE
          </button>
          <button
            onClick={() => {
              setMode(AppMode.DECODE);
              reset();
            }}
            className={cn(
              "flex-1 md:flex-none relative px-4 md:px-8 py-2 md:py-2.5 rounded-lg md:rounded-xl text-xs md:text-sm font-bold transition-all z-10",
              mode === AppMode.DECODE
                ? "text-white"
                : "text-slate-500 hover:text-white",
            )}
          >
            {mode === AppMode.DECODE && (
              <motion.div
                layoutId="active-tab"
                className="absolute inset-0 bg-indigo-600 rounded-lg md:rounded-xl shadow-lg -z-10"
                transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
              />
            )}
            UNPACK
          </button>
        </nav>
      </header>

      <main className="w-full max-w-4xl space-y-6 md:space-y-8">
        <AnimatePresence mode="wait">
          {!result && !progress && !isEncryptedVolume && !resumeJob && (
            <motion.div
              key="input-section"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6 md:space-y-8"
            >
              <div className="bg-slate-900/50 border border-slate-800 rounded-2xl md:rounded-3xl p-4 md:p-6 flex flex-col md:flex-row gap-4 md:gap-6 items-center">
                <div className="flex-1 w-full space-y-2">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                    <Lock className="w-3 h-3" />
                    Cell Security Key
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder="Optional Passphrase..."
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      aria-label="Cell security password"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white placeholder:text-slate-700 focus:outline-none focus:border-indigo-500 transition-all font-bold text-sm md:text-base"
                    />
                    <button
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-600 hover:text-indigo-400"
                    >
                      {showPassword ? (
                        <EyeOff className="w-5 h-5" />
                      ) : (
                        <Eye className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                  {password && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px] font-mono">
                        <span className="text-slate-500">Strength</span>
                        <span className={cn(
                          passwordAssessment.label === "Strong" ? "text-emerald-400" :
                          passwordAssessment.label === "Good" ? "text-indigo-400" :
                          passwordAssessment.label === "Fair" ? "text-amber-400" : "text-red-400",
                        )}>
                          {passwordAssessment.label}
                        </span>
                      </div>
                      <div className="h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                        <div
                          className={cn(
                            "h-full transition-all",
                            passwordAssessment.label === "Strong" ? "bg-emerald-500" :
                            passwordAssessment.label === "Good" ? "bg-indigo-500" :
                            passwordAssessment.label === "Fair" ? "bg-amber-500" : "bg-red-500",
                          )}
                          style={{ width: `${Math.max(10, passwordAssessment.score * 20)}%` }}
                        />
                      </div>
                      {passwordAssessment.warnings[0] && (
                        <p className="text-[10px] text-amber-400">{passwordAssessment.warnings[0]}</p>
                      )}
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-[10px] text-slate-400">
                    <input
                      type="checkbox"
                      checked={useArgon2id}
                      onChange={(e) => setUseArgon2id(e.target.checked)}
                      className="accent-indigo-500"
                    />
                    Harden password with Argon2id in app decode path
                  </label>
                  {useArgon2id && (
                    <p className="text-[10px] text-amber-400">
                      Argon2id archives require the HDA app for extraction until standalone browser support is expanded.
                    </p>
                  )}
                  {mode === AppMode.ENCODE && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">
                      <input
                        value={passwordHint}
                        onChange={(e) => setPasswordHint(e.target.value)}
                        placeholder="Optional password hint"
                        aria-label="Archive password hint"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white placeholder:text-slate-700 text-xs"
                      />
                      <input
                        value={archiveTags}
                        onChange={(e) => setArchiveTags(e.target.value)}
                        placeholder="Tags: backup, iso, release"
                        aria-label="Archive tags"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white placeholder:text-slate-700 text-xs"
                      />
                      <textarea
                        value={archiveComment}
                        onChange={(e) => setArchiveComment(e.target.value)}
                        placeholder="Archive comment / operator notes"
                        aria-label="Archive comment"
                        className="md:col-span-2 min-h-20 w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white placeholder:text-slate-700 text-xs"
                      />
                      <textarea
                        value={recipientDraft}
                        onChange={(e) => setRecipientDraft(e.target.value)}
                        placeholder="Multi-recipient access, one per line: label:password"
                        aria-label="Multi recipient configuration"
                        className="md:col-span-2 min-h-24 w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white placeholder:text-slate-700 text-xs"
                      />
                      <label className="flex items-center gap-2 text-[10px] text-slate-400">
                        <input
                          type="checkbox"
                          checked={integrityOnly}
                          onChange={(e) => setIntegrityOnly(e.target.checked)}
                          className="accent-emerald-500"
                        />
                        Integrity-only archive mode (no encryption)
                      </label>
                      <label className="flex items-center gap-2 text-[10px] text-slate-400">
                        <input
                          type="checkbox"
                          checked={diagnosticsOptIn}
                          onChange={(e) => setDiagnosticsOptInState(e.target.checked)}
                          className="accent-indigo-500"
                        />
                        Opt in to diagnostics telemetry
                      </label>
                    </div>
                  )}
                </div>
              </div>

              {persistedResume && (
                <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-2xl p-4 md:p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-indigo-400">
                      Persistent Resume Checkpoint
                    </p>
                    <p className="text-sm text-slate-300">
                      Suspended {persistedResume.mode === AppMode.ENCODE ? "encode" : "decode"} job detected for{" "}
                      <span className="font-bold break-all text-white">{persistedResume.fileName}</span>.
                    </p>
                    <p className="text-xs text-slate-500">
                      Re-select the same source file to continue from the IndexedDB checkpoint.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {persistedResume.hasSourceFileHandle && (
                      <button
                        onClick={async () => {
                          const checkpoint = await getCheckpoint(persistedResume.resumeKey);
                          const sourceHandle = checkpoint?.sourceFileHandle;
                          if (!sourceHandle) return;
                          const persistedFile = await sourceHandle.getFile();
                          setMode(persistedResume.mode);
                          await processFile(persistedFile, password || null, { sourceFileHandle: sourceHandle });
                        }}
                        className="text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl px-4 py-2 text-[10px] font-bold uppercase tracking-widest"
                      >
                        Resume From Saved Source
                      </button>
                    )}
                    <button
                      onClick={() => {
                        void clearCheckpoint(persistedResume.resumeKey).then(() => {
                          setPersistedResume(null);
                        });
                      }}
                      className="text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 rounded-xl px-4 py-2 text-[10px] font-bold uppercase tracking-widest"
                    >
                      Discard Checkpoint
                    </button>
                  </div>
                </div>
              )}

              {(!platform.fileSystemAccess || !platform.compressionStreams) && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 text-sm text-slate-300">
                  <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-amber-400">
                    Compatibility Mode: {platform.browserLabel}
                  </p>
                  <p className="mt-2">
                    {platform.fileSystemAccess
                      ? "Direct-to-disk handles are partially available."
                      : "File System Access API is unavailable, so downloads use browser memory fallback."}
                  </p>
                  {!platform.compressionStreams && (
                    <p className="mt-1">
                      Native compression streams are unavailable. The app will fall back to pure-JS deflate paths where possible.
                    </p>
                  )}
                </div>
              )}

              {jobQueue.length > 0 && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
                  <p className="text-[10px] font-mono text-indigo-400 uppercase tracking-[0.3em]">Queued Jobs</p>
                  <div className="mt-3 space-y-2 text-sm text-slate-300">
                    {jobQueue.map((job) => (
                      <div key={`${job.file.name}:${job.file.lastModified}`} className="flex items-center justify-between">
                        <span className="break-all">{job.file.name}</span>
                        <span className="text-slate-500 text-xs">{formatBytes(job.file.size)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label={mode === AppMode.ENCODE ? "Select files to encode" : "Select archives to inspect"}
                className={cn(
                  "group relative cursor-pointer bg-slate-900/40 border transition-all rounded-[1.5rem] md:rounded-[2.5rem] p-8 md:p-20 text-center shadow-2xl overflow-hidden",
                  isDragging
                    ? "border-indigo-500 bg-indigo-900/20 scale-[1.02]"
                    : "border-slate-800 hover:border-indigo-500/50",
                )}
              >
                <div className="absolute top-0 left-0 w-1 md:w-1.5 h-full bg-indigo-600 transition-all group-hover:w-2.5"></div>
                <input
                  type="file"
                  multiple={mode === AppMode.DECODE}
                  className="hidden"
                  ref={fileInputRef}
                  aria-label="file picker"
                  onChange={(e) =>
                    e.target.files?.length &&
                    processFiles(e.target.files, password || null)
                  }
                />
                <input
                  type="file"
                  multiple
                  className="hidden"
                  ref={folderInputRef}
                  {...({ webkitdirectory: "true", directory: "" } as Record<string, string>)}
                  onChange={(e) =>
                    e.target.files?.length &&
                    processFiles(e.target.files, password || null)
                  }
                />
                <div className="flex flex-col items-center gap-4 md:gap-6 pointer-events-none">
                  <div
                    className={cn(
                      "bg-slate-900/80 p-6 md:p-8 rounded-[1.5rem] md:rounded-[2rem] border transition-all shadow-inner",
                      isDragging
                        ? "border-indigo-500 scale-110"
                        : "border-slate-800 group-hover:scale-105 group-hover:border-indigo-500",
                    )}
                  >
                    {mode === AppMode.ENCODE ? (
                      <UploadCloud className="w-10 h-10 md:w-16 md:h-16 text-indigo-400" />
                    ) : (
                      <Layers className="w-10 h-10 md:w-16 md:h-16 text-indigo-400" />
                    )}
                  </div>
                  <div className="space-y-2">
                    <p className="text-2xl md:text-4xl font-black tracking-tight serif text-white uppercase">
                      {isDragging
                        ? "Drop to Initiate"
                        : mode === AppMode.ENCODE
                          ? "Deploy Hive"
                          : "Unpack Hive"}
                    </p>
                    <p className="text-slate-500 text-xs md:text-base">
                      {isDragging
                        ? "Release to begin processing"
                        : mode === AppMode.ENCODE
                          ? "Fragment and seal file into a Protocol v4.0 hive"
                          : "Select an .hda.html hive for integrity-checked extraction"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-col md:flex-row gap-3">
                <button
                  onClick={() => folderInputRef.current?.click()}
                  className="flex-1 bg-slate-900/60 border border-slate-800 text-slate-200 font-bold py-3 rounded-xl uppercase tracking-widest text-xs flex items-center justify-center gap-2"
                  aria-label="Queue folder files"
                >
                  <FolderOpen className="w-4 h-4" />
                  Queue Folder Batch
                </button>
                <button
                  onClick={openWithFileAccess}
                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 rounded-xl uppercase tracking-widest text-xs flex items-center justify-center gap-2"
                  aria-label="Open files with persistent file access handles"
                >
                  <UploadCloud className="w-4 h-4" />
                  Persistent File Access
                </button>
              </div>
            </motion.div>
          )}

          {!result && !progress && !isEncryptedVolume && resumeJob && (
            <motion.div
              key="resume-section"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-slate-900 border border-indigo-500/30 rounded-2xl md:rounded-[2.5rem] p-6 md:p-10 shadow-2xl"
            >
              <div className="space-y-4 text-center">
                <h3 className="serif text-2xl font-bold text-white uppercase tracking-tight">
                  Operation Suspended
                </h3>
                <p className="text-slate-400 text-sm md:text-base">
                  Resume the interrupted {resumeJob.mode === AppMode.ENCODE ? "encode" : "decode"} job for{" "}
                  <span className="text-white font-bold break-all">{resumeJob.file.name}</span>.
                </p>
                <div className="flex flex-col md:flex-row gap-3 justify-center">
                  <button
                    onClick={() => {
                      setMode(resumeJob.mode);
                      processFile(resumeJob.file, resumeJob.password, resumeJob.options);
                    }}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white font-black py-3 px-6 rounded-xl uppercase tracking-widest text-sm"
                  >
                    Resume Job
                  </button>
                  <button
                    onClick={() => setResumeJob(null)}
                    className="text-slate-500 hover:text-white font-bold py-3 px-6 uppercase tracking-widest text-sm"
                  >
                    Discard Resume State
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {inspection && !progress && !result && (
            <motion.div
              key="inspection-section"
              initial={reduceMotion ? false : { opacity: 0, y: 20 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl md:rounded-[2.5rem] p-6 md:p-10 shadow-2xl space-y-6"
            >
              <div className="flex items-center gap-3">
                <ShieldCheck className="w-6 h-6 text-emerald-400" />
                <div>
                  <h3 className="text-xl font-black text-white uppercase tracking-tight">Archive Inspector</h3>
                  <p className="text-slate-400 text-sm">Review archive metadata before extraction or run a quick integrity test.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">Filename</p>
                  <p className="text-white break-all font-bold">{inspection.details.filename}</p>
                </div>
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">Protocol</p>
                  <p className="text-white font-bold">v{inspection.details.version}</p>
                </div>
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">Cells</p>
                  <p className="text-white font-bold">{inspection.details.cellCount}</p>
                </div>
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">Encryption</p>
                  <p className="text-white font-bold">{inspection.details.encryption ?? "None"}</p>
                </div>
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">Signature</p>
                  <p className="text-white font-bold">{inspection.details.signature?.algorithm ?? "Unsigned"}</p>
                </div>
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">KDF</p>
                  <p className="text-white font-bold">{inspection.details.kdf?.algorithm ?? "PBKDF2-SHA256"}</p>
                </div>
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">Hint</p>
                  <p className="text-white font-bold">{inspection.details.passwordHint || "None"}</p>
                </div>
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">Recipients</p>
                  <p className="text-white font-bold">{inspection.details.recipients?.length ?? 0}</p>
                </div>
              </div>
              {inspection.details.comment && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">Comment</p>
                  <p className="text-slate-300 text-xs mt-2 whitespace-pre-wrap">{inspection.details.comment}</p>
                </div>
              )}
              {inspection.details.tags?.length ? (
                <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">Tags</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {inspection.details.tags.map((tag) => (
                      <span key={tag} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-[10px] text-slate-300 uppercase tracking-widest">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {inspection.details.preview?.kind === "text" && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">Preview</p>
                  <p className="text-slate-300 text-xs mt-2 whitespace-pre-wrap">{inspection.details.preview.textSnippet}</p>
                </div>
              )}
              {inspection.details.preview?.kind === "image" && inspection.details.preview.imageUrl && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
                  <p className="text-slate-500 text-[10px] uppercase tracking-widest">Preview</p>
                  <img src={inspection.details.preview.imageUrl} alt="Archive preview" className="mt-3 max-h-64 rounded-xl border border-slate-800" />
                </div>
              )}
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
                <p className="text-slate-500 text-[10px] uppercase tracking-widest">Checksums</p>
                <p className="text-slate-300 text-xs break-all mt-2">{inspection.details.checksums.slice(0, 8).join(", ")}{inspection.details.checksums.length > 8 ? " ..." : ""}</p>
              </div>
              {inspection.details.folderManifest && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 space-y-3">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div>
                      <p className="text-slate-500 text-[10px] uppercase tracking-widest">Folder Manifest</p>
                      <p className="text-slate-300 text-xs mt-1">
                        {inspection.details.folderManifest.rootPath} • {inspection.details.folderManifest.entries.length} entries
                      </p>
                    </div>
                    <input
                      value={inspectionSearch}
                      onChange={(e) => setInspectionSearch(e.target.value)}
                      placeholder="Search folder metadata"
                      aria-label="Search folder metadata"
                      className="w-full md:w-64 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white"
                    />
                  </div>
                  <div className="max-h-48 overflow-auto space-y-2">
                    {filteredFolderEntries.slice(0, 50).map((entry) => (
                      <div key={entry.relativePath} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs">
                        <span className="break-all text-slate-300">{entry.relativePath}</span>
                        <span className="shrink-0 text-slate-500">{formatBytes(entry.size)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-col md:flex-row gap-3">
                <button
                  onClick={() => processFile(inspection.file, password || null, { companionFiles: inspection.companions })}
                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-black py-3 rounded-xl uppercase tracking-widest text-sm"
                >
                  Extract Archive
                </button>
                <button
                  onClick={verifyInspectedArchive}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-black py-3 rounded-xl uppercase tracking-widest text-sm flex items-center justify-center gap-2"
                >
                  <ListChecks className="w-4 h-4" />
                  Test Integrity
                </button>
              </div>
            </motion.div>
          )}

          {isEncryptedVolume && !result && (
            <motion.div
              key="encrypted-section"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-slate-900 border border-amber-500/30 rounded-2xl md:rounded-[2.5rem] p-6 md:p-16 shadow-2xl text-center"
            >
              <div className="bg-amber-500/10 w-16 h-16 md:w-20 md:h-20 rounded-full flex items-center justify-center mx-auto mb-6">
                <ShieldAlert className="w-8 h-8 md:w-10 md:h-10 text-amber-500" />
              </div>
              <h3 className="serif text-2xl md:text-3xl font-bold mb-2 text-white uppercase tracking-tight">
                Encrypted Hive
              </h3>
              <p className="text-slate-400 text-sm md:text-base mb-8">
                Access restricted. Provide Master Key to initiate cellular
                stream.
              </p>
              <div className="max-w-sm mx-auto space-y-4">
                <input
                  type="password"
                  placeholder="Master Key..."
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void processFile(pendingFile!, password, pendingOptions);
                    }
                  }}
                  aria-label="Archive decryption password"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl md:rounded-2xl px-4 md:px-6 py-3 md:py-4 text-white focus:outline-none focus:border-amber-500 transition-all text-center text-lg md:text-xl font-bold"
                  autoFocus
                />
                {passwordAssessment.warnings[0] && (
                  <p className="text-[10px] text-amber-300">{passwordAssessment.warnings[0]}</p>
                )}
                <button
                  onClick={() => processFile(pendingFile!, password, pendingOptions)}
                  className="w-full bg-amber-500 text-slate-950 font-black py-3 md:py-4 rounded-xl md:rounded-2xl shadow-xl hover:scale-[1.02] transition-transform active:scale-95 text-sm md:text-base"
                >
                  UNLOCK STREAM
                </button>
                <button
                  onClick={reset}
                  className="w-full text-slate-500 hover:text-white font-bold py-2 transition-all uppercase text-[10px] tracking-widest"
                >
                  CANCEL
                </button>
              </div>
            </motion.div>
          )}

          {progress && (
            <motion.div
              key="progress-section"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl md:rounded-[2.5rem] p-6 md:p-12 shadow-2xl space-y-8 md:space-y-12"
            >
              <div className="flex flex-col items-center gap-6 md:gap-8 max-w-md mx-auto text-center">
                <div className="relative">
                  <RefreshCcw className="w-12 h-12 md:w-16 md:h-16 text-indigo-500 animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Cpu className="w-4 h-4 md:w-6 md:h-6 text-indigo-400" />
                  </div>
                </div>
                <div className="w-full space-y-4">
                  <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 transition-all duration-300 shadow-[0_0_15px_rgba(99,102,241,0.6)]"
                      style={{ width: `${progress.percentage}%` }}
                    ></div>
                  </div>
                  <div className="text-[10px] font-mono text-indigo-400 uppercase tracking-[0.3em] font-bold animate-pulse">
                    {progress.status}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[10px] font-mono text-slate-400">
                    <div className="bg-slate-950/80 rounded-lg px-3 py-2 border border-slate-800">
                      {progress.currentCell ?? 0}/{progress.totalCells ?? 0} Cells
                    </div>
                    <div className="bg-slate-950/80 rounded-lg px-3 py-2 border border-slate-800">
                      {formatBytes(progress.processedBytes ?? 0)}/{formatBytes(progress.totalBytes ?? 0)}
                    </div>
                    <div className="bg-slate-950/80 rounded-lg px-3 py-2 border border-slate-800">
                      {progress.mode === "disk" ? "Disk Stream" : "Memory Mode"}
                    </div>
                    <div className="bg-slate-950/80 rounded-lg px-3 py-2 border border-slate-800">
                      {formatBytes(Math.round(progress.throughputBytesPerSecond ?? 0))}/s
                    </div>
                    <div className="bg-slate-950/80 rounded-lg px-3 py-2 border border-slate-800">
                      ETA {progress.etaSeconds != null ? `${Math.max(1, Math.round(progress.etaSeconds))}s` : "--"}
                    </div>
                    <div className="bg-slate-950/80 rounded-lg px-3 py-2 border border-slate-800">
                      {Math.round((progress.cellSize ?? 0) / (1024 * 1024))} MB Cells
                    </div>
                  </div>
                  <button
                    onClick={() => abortControllerRef.current?.abort()}
                    className="w-full bg-red-500/20 border border-red-500/30 text-red-400 font-black py-3 rounded-xl uppercase tracking-widest text-xs hover:bg-red-500/30 transition-colors"
                  >
                    Cancel Operation
                  </button>
                </div>
              </div>

              {progress.logs && (
                <div
                  ref={terminalRef}
                  aria-live="polite"
                  className="bg-black/60 rounded-xl p-4 md:p-6 h-32 overflow-y-auto border border-slate-800 font-mono text-[9px] text-emerald-500 space-y-1 shadow-inner scroll-smooth"
                >
                  {progress.logs.map((log, idx) => (
                    <div key={idx} className="flex gap-2">
                      <span className="text-slate-600">
                        [{new Date().toLocaleTimeString()}]
                      </span>
                      <span>{log}</span>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {result && (
            <motion.div
              key="result-section"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8"
            >
              <div className="bg-slate-900/40 border border-slate-800 rounded-2xl md:rounded-[2.5rem] p-8 md:p-12 flex flex-col items-center justify-center">
                <div
                  className={`relative w-32 h-32 md:w-40 md:h-40 flex items-center justify-center border-4 rounded-[2.5rem] md:rounded-[3.5rem] ${result.metadata.isEncrypted ? "border-amber-500" : "border-indigo-500"} shadow-[0_0_40px_-10px_rgba(99,102,241,0.2)]`}
                >
                  {result.metadata.isEncrypted ? (
                    <Lock className="w-10 h-10 md:w-12 md:h-12 text-amber-500" />
                  ) : (
                    <Unlock className="w-10 h-10 md:w-12 md:h-12 text-indigo-500" />
                  )}
                </div>
                <div className="mt-6 md:mt-8 text-center">
                  <h4 className="serif text-lg md:text-xl font-bold text-white uppercase tracking-tight">
                    {mode === AppMode.ENCODE
                      ? "Hive Synchronized"
                      : "Payload Restored"}
                  </h4>
                  <p className="text-slate-500 text-[10px] font-mono mt-2 uppercase tracking-[0.4em]">
                    v4.0 Integrity Verified
                  </p>
                </div>
              </div>

              <div className="bg-slate-900/60 border border-slate-800 rounded-2xl md:rounded-[2.5rem] p-6 md:p-10 flex flex-col justify-between shadow-2xl">
                <div className="space-y-4">
                  <p className="text-white serif text-xl md:text-2xl font-bold break-all leading-tight tracking-tight">
                    {result.metadata.name}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <div className="bg-indigo-900/30 px-3 py-1 rounded-lg text-[10px] font-mono text-indigo-400 border border-indigo-900/50 uppercase tracking-widest">
                      {formatBytes(result.metadata.size)}
                    </div>
                    {result.metadata.isEncrypted && (
                      <div className="bg-amber-900/30 px-3 py-1 rounded-lg text-[10px] font-mono text-amber-500 border border-amber-900/50 uppercase tracking-widest font-bold">
                        ENCRYPTED
                      </div>
                    )}
                    <div className="bg-slate-800/50 px-3 py-1 rounded-lg text-[10px] font-mono text-slate-400 border border-slate-700 uppercase tracking-widest">
                      PROTOCOL 4.0
                    </div>
                  </div>
                </div>

                <div className="mt-8 md:mt-12 space-y-4">
                  {result.blob && result.blob.size > 0 ? (
                    <button
                      onClick={() => handleDownload()}
                      className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black py-4 md:py-5 rounded-xl md:rounded-2xl flex items-center justify-center gap-3 transition-all shadow-xl uppercase tracking-tighter hover:scale-[1.02] active:scale-95 text-xs md:text-sm"
                    >
                      <Sparkles className="w-4 h-4 md:w-5 md:h-5" />
                      {mode === AppMode.ENCODE ? "Save HDA Hive" : "Save Reconstituted File"}
                    </button>
                  ) : (
                    <div className="w-full bg-emerald-600/20 text-emerald-500 border border-emerald-500/30 font-black py-4 md:py-5 rounded-xl md:rounded-2xl flex items-center justify-center gap-3 shadow-xl uppercase tracking-tighter text-xs md:text-sm">
                      <Sparkles className="w-4 h-4 md:w-5 md:h-5" />
                      Saved to Disk
                    </div>
                  )}
                  <button
                    onClick={reset}
                    className="w-full text-slate-500 hover:text-white font-bold py-2 transition-all uppercase text-[10px] tracking-widest"
                  >
                    Reset Terminal
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 leading-relaxed mt-4">
                  {secureDeleteGuidance()}
                </p>
              </div>
            </motion.div>
          )}

          {batchResults.length > 1 && (
            <motion.div
              key="batch-results"
              initial={reduceMotion ? false : { opacity: 0, y: 12 }}
              animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              className="bg-slate-900/50 border border-slate-800 rounded-2xl p-6 space-y-4"
            >
              <h3 className="text-white font-black uppercase tracking-tight">Batch Results</h3>
              <div className="space-y-3">
                {batchResults.map((item) => (
                  <div key={`${item.metadata.name}:${item.metadata.timestamp}`} className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-slate-950/70 border border-slate-800 rounded-xl p-4">
                    <div>
                      <p className="text-white font-bold break-all">{item.metadata.name}</p>
                      <p className="text-slate-500 text-xs">{formatBytes(item.metadata.size)}</p>
                    </div>
                    <button
                      onClick={() => handleDownload(item)}
                      disabled={!item.blob || item.blob.size === 0}
                      className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold py-2 px-4 rounded-xl text-xs uppercase tracking-widest"
                    >
                      {item.blob && item.blob.size > 0 ? "Download" : "Saved To Disk"}
                    </button>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {error && (
            <motion.div
              key="error-section"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-red-500/10 border border-red-500/20 rounded-2xl md:rounded-3xl p-6 md:p-8 flex items-start gap-4 md:gap-6 shadow-2xl"
            >
              <AlertCircle className="w-6 h-6 md:w-8 md:h-8 text-red-500 flex-shrink-0" />
              <div className="space-y-1">
                <h3 className="text-base md:text-lg font-bold text-red-500 uppercase tracking-tighter">
                  Protocol Violation
                </h3>
                <p className="text-slate-400 text-xs md:text-sm leading-relaxed">
                  {error}
                </p>
                <button
                  onClick={reset}
                  className="text-indigo-400 font-bold text-[10px] mt-4 uppercase tracking-widest hover:text-indigo-300 transition-colors"
                >
                  Force System Reboot
                </button>
                {securityFeed.length > 0 && (
                  <div className="mt-4 space-y-1 text-[10px] font-mono text-amber-300" aria-live="polite">
                    {securityFeed.map((item) => (
                      <div key={item}>{item}</div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="w-full max-w-4xl mt-16 md:mt-32 py-8 md:py-12 border-t border-slate-900 grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 text-center md:text-left">
        <div className="space-y-4">
          <Terminal className="w-5 h-5 md:w-6 md:h-6 text-indigo-500 mx-auto md:mx-0" />
          <h4 className="text-slate-200 font-bold uppercase text-[10px] tracking-widest">
            Binary Integrity Shield
          </h4>
          <p className="text-[10px] md:text-[11px] text-slate-500 leading-relaxed font-mono">
            Each cell is verified against a SHA-256 fingerprint during
            extraction. Data corruption within the container is automatically
            detected.
          </p>
        </div>
        <div className="space-y-4">
          <Cpu className="w-5 h-5 md:w-6 md:h-6 text-indigo-500 mx-auto md:mx-0" />
          <h4 className="text-slate-200 font-bold uppercase text-[10px] tracking-widest">
            Parallel Stream Logic
          </h4>
          <p className="text-[10px] md:text-[11px] text-slate-500 leading-relaxed font-mono">
            Protocol 4.0 scales based on hardware concurrency. High-performance
            devices utilize multi-thread cell forging for 400% faster
            extraction.
          </p>
        </div>

        <div className="col-span-full mt-4 md:mt-8 pt-6 md:pt-8 border-t border-slate-900/50 flex flex-col items-center justify-center space-y-2 text-center">
          <p className="text-slate-400 text-[10px] md:text-xs font-mono">
            © {new Date().getFullYear()} <span className="text-indigo-400 font-bold">Raj Mitra</span>. All rights reserved.
          </p>
          <p className="text-slate-500 text-[9px] md:text-[10px] font-mono">
            Build {BUILD_METADATA.version} • Protocol {BUILD_METADATA.protocol} • {BUILD_METADATA.commit.slice(0, 7)} • {new Date(BUILD_METADATA.buildTime).toLocaleString()}
          </p>
          <p className="text-slate-500 text-[9px] md:text-[10px] font-mono max-w-lg px-4">
            Creator of HDA - Hive Data Architecture.<br className="hidden md:block"/>
            Licensed under PolyForm Noncommercial 1.0.0. Commercial use requires a commercial license.
          </p>
        </div>
      </footer>
    </div>
  );
};

// ─── App with Error Boundary ──────────────────────────────────────
const App: React.FC = () => (
  <ErrorBoundary>
    <AppContent />
  </ErrorBoundary>
);

export default App;

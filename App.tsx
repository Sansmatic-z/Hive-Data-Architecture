import React, { useState, useRef, useEffect, useCallback } from "react";
import { AppMode, FileMetadata, ProcessingProgress } from "./types";
import { decodeFromHDA } from "./services/hdaDecoder";
import { generateHDA } from "./services/hdaEncoder";
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
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn, formatBytes } from "./lib/utils";

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>(AppMode.ENCODE);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    blob: Blob;
    metadata: FileMetadata;
  } | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isEncryptedVolume, setIsEncryptedVolume] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [progress?.logs]);

  const processFile = async (file: File, pass: string | null = null) => {
    setProgress({
      percentage: 0,
      status: "Initializing...",
      logs: ["[CORE] Cold Boot Ready"],
    });
    setError(null);
    setResult(null);

    try {
      if (mode === AppMode.ENCODE) {
        const resultData = await generateHDA(file, pass, (p: any) =>
          setProgress(p),
        );
        if (!resultData) {
          setProgress(null);
          return;
        }
        setResult({
          blob: (resultData as any).blob || new Blob(),
          metadata: resultData,
        });
      } else {
        try {
          const decoded = await decodeFromHDA(file, pass, (p: any) =>
            setProgress(p),
          );
          if (!decoded) {
            setProgress(null);
            return;
          }
          setResult(decoded);
          setIsEncryptedVolume(false);
        } catch (err: any) {
          if (err.message === "ENCRYPTED_VOLUME") {
            setIsEncryptedVolume(true);
            setPendingFile(file);
            setProgress(null);
          } else {
            throw err;
          }
        }
      }
    } catch (err: any) {
      setError(err.message || "System error encountered.");
    } finally {
      if (!isEncryptedVolume) setProgress(null);
    }
  };

  const handleDownload = () => {
    if (!result || !result.blob || result.blob.size === 0) return;
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download =
      mode === AppMode.ENCODE
        ? `${result.metadata.name}.hda.html`
        : result.metadata.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const reset = () => {
    setResult(null);
    setError(null);
    setProgress(null);
    setPassword("");
    setIsEncryptedVolume(false);
    setPendingFile(null);
    setIsDragging(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
        processFile(e.dataTransfer.files[0], password || null);
      }
    },
    [password, mode],
  );

  return (
    <div className="min-h-screen flex flex-col items-center p-4 md:p-8 honeycomb">
      <header className="w-full max-w-4xl flex flex-col md:flex-row justify-between items-center mb-16 gap-8">
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="absolute inset-0 bg-indigo-500 blur-xl opacity-50 rounded-full"></div>
            <div className="relative bg-indigo-600 p-3 rounded-2xl shadow-xl transform -rotate-6 transition-transform hover:rotate-0">
              <Hexagon className="w-8 h-8 text-white" />
            </div>
          </div>
          <div>
            <h1 className="text-4xl font-black tracking-tighter serif text-white uppercase">
              HDA<span className="text-indigo-400">Vault</span>
            </h1>
            <p className="text-slate-500 font-mono text-[10px] tracking-[0.3em] uppercase">
              Protocol v3.0 • Elite Forge
            </p>
          </div>
        </div>

        <nav className="flex bg-slate-900/80 p-1.5 rounded-2xl border border-slate-800 backdrop-blur-md relative">
          <button
            onClick={() => {
              setMode(AppMode.ENCODE);
              reset();
            }}
            className={cn(
              "relative px-8 py-2.5 rounded-xl text-sm font-bold transition-all z-10",
              mode === AppMode.ENCODE
                ? "text-white"
                : "text-slate-500 hover:text-white",
            )}
          >
            {mode === AppMode.ENCODE && (
              <motion.div
                layoutId="active-tab"
                className="absolute inset-0 bg-indigo-600 rounded-xl shadow-lg -z-10"
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
              "relative px-8 py-2.5 rounded-xl text-sm font-bold transition-all z-10",
              mode === AppMode.DECODE
                ? "text-white"
                : "text-slate-500 hover:text-white",
            )}
          >
            {mode === AppMode.DECODE && (
              <motion.div
                layoutId="active-tab"
                className="absolute inset-0 bg-indigo-600 rounded-xl shadow-lg -z-10"
                transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
              />
            )}
            UNPACK
          </button>
        </nav>
      </header>

      <main className="w-full max-w-4xl space-y-8">
        <AnimatePresence mode="wait">
          {!result && !progress && !isEncryptedVolume && (
            <motion.div
              key="input-section"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 flex flex-col md:flex-row gap-6 items-center">
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
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white placeholder:text-slate-700 focus:outline-none focus:border-indigo-500 transition-all font-bold"
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
                </div>
              </div>

              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                className={cn(
                  "group relative cursor-pointer bg-slate-900/40 border transition-all rounded-[2.5rem] p-20 text-center shadow-2xl overflow-hidden",
                  isDragging
                    ? "border-indigo-500 bg-indigo-900/20 scale-[1.02]"
                    : "border-slate-800 hover:border-indigo-500/50",
                )}
              >
                <div className="absolute top-0 left-0 w-1.5 h-full bg-indigo-600 transition-all group-hover:w-2.5"></div>
                <input
                  type="file"
                  className="hidden"
                  ref={fileInputRef}
                  onChange={(e) =>
                    e.target.files?.[0] &&
                    processFile(e.target.files[0], password || null)
                  }
                />
                <div className="flex flex-col items-center gap-6 pointer-events-none">
                  <div
                    className={cn(
                      "bg-slate-900/80 p-8 rounded-[2rem] border transition-all shadow-inner",
                      isDragging
                        ? "border-indigo-500 scale-110"
                        : "border-slate-800 group-hover:scale-105 group-hover:border-indigo-500",
                    )}
                  >
                    {mode === AppMode.ENCODE ? (
                      <UploadCloud className="w-16 h-16 text-indigo-400" />
                    ) : (
                      <Layers className="w-16 h-16 text-indigo-400" />
                    )}
                  </div>
                  <div className="space-y-2">
                    <p className="text-4xl font-black tracking-tight serif text-white uppercase">
                      {isDragging
                        ? "Drop to Initiate"
                        : mode === AppMode.ENCODE
                          ? "Deploy Hive"
                          : "Unpack Hive"}
                    </p>
                    <p className="text-slate-500">
                      {isDragging
                        ? "Release to begin processing"
                        : mode === AppMode.ENCODE
                          ? "Fragment and seal file into a Protocol v3.0 hive"
                          : "Select an .hda.html hive for integrity-checked extraction"}
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {isEncryptedVolume && !result && (
            <motion.div
              key="encrypted-section"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-slate-900 border border-amber-500/30 rounded-[2.5rem] p-16 shadow-2xl text-center"
            >
              <div className="bg-amber-500/10 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6">
                <ShieldAlert className="w-10 h-10 text-amber-500" />
              </div>
              <h3 className="serif text-3xl font-bold mb-2 text-white uppercase tracking-tight">
                Encrypted Hive
              </h3>
              <p className="text-slate-400 mb-8">
                Access restricted. Provide Master Key to initiate cellular
                stream.
              </p>
              <div className="max-w-sm mx-auto space-y-4">
                <input
                  type="password"
                  placeholder="Master Key..."
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && processFile(pendingFile!, password)
                  }
                  className="w-full bg-slate-950 border border-slate-700 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-amber-500 transition-all text-center text-xl font-bold"
                  autoFocus
                />
                <button
                  onClick={() => processFile(pendingFile!, password)}
                  className="w-full bg-amber-500 text-slate-950 font-black py-4 rounded-2xl shadow-xl hover:scale-[1.02] transition-transform active:scale-95"
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
              className="bg-slate-900 border border-slate-800 rounded-[2.5rem] p-12 shadow-2xl space-y-12"
            >
              <div className="flex flex-col items-center gap-8 max-w-md mx-auto text-center">
                <div className="relative">
                  <RefreshCcw className="w-16 h-16 text-indigo-500 animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Cpu className="w-6 h-6 text-indigo-400" />
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
                </div>
              </div>

              {progress.logs && (
                <div
                  ref={terminalRef}
                  className="bg-black/60 rounded-2xl p-6 h-32 overflow-y-auto border border-slate-800 font-mono text-[9px] text-emerald-500 space-y-1 shadow-inner scroll-smooth"
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
              className="grid md:grid-cols-2 gap-8"
            >
              <div className="bg-slate-900/40 border border-slate-800 rounded-[2.5rem] p-12 flex flex-col items-center justify-center">
                <div
                  className={`relative w-40 h-40 flex items-center justify-center border-4 rounded-[3.5rem] ${result.metadata.isEncrypted ? "border-amber-500" : "border-indigo-500"} shadow-[0_0_40px_-10px_rgba(99,102,241,0.2)]`}
                >
                  {result.metadata.isEncrypted ? (
                    <Lock className="w-12 h-12 text-amber-500" />
                  ) : (
                    <Unlock className="w-12 h-12 text-indigo-500" />
                  )}
                </div>
                <div className="mt-8 text-center">
                  <h4 className="serif text-xl font-bold text-white uppercase tracking-tight">
                    {mode === AppMode.ENCODE
                      ? "Hive Synchronized"
                      : "Payload Restored"}
                  </h4>
                  <p className="text-slate-500 text-[10px] font-mono mt-2 uppercase tracking-[0.4em]">
                    v3.0 Integrity Verified
                  </p>
                </div>
              </div>

              <div className="bg-slate-900/60 border border-slate-800 rounded-[2.5rem] p-10 flex flex-col justify-between shadow-2xl">
                <div className="space-y-4">
                  <p className="text-white serif text-2xl font-bold break-all leading-tight tracking-tight">
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
                      PROTOCOL 3.0
                    </div>
                  </div>
                </div>

                <div className="mt-12 space-y-4">
                  {result.blob && result.blob.size > 0 ? (
                    <button
                      onClick={handleDownload}
                      className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black py-5 rounded-2xl flex items-center justify-center gap-3 transition-all shadow-xl uppercase tracking-tighter hover:scale-[1.02] active:scale-95"
                    >
                      <Sparkles className="w-5 h-5" />
                      {mode === AppMode.ENCODE ? "Save HDA Hive" : "Save Reconstituted File"}
                    </button>
                  ) : (
                    <div className="w-full bg-emerald-600/20 text-emerald-500 border border-emerald-500/30 font-black py-5 rounded-2xl flex items-center justify-center gap-3 shadow-xl uppercase tracking-tighter">
                      <Sparkles className="w-5 h-5" />
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
              </div>
            </motion.div>
          )}

          {error && (
            <motion.div
              key="error-section"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-red-500/10 border border-red-500/20 rounded-3xl p-8 flex items-start gap-6 shadow-2xl"
            >
              <AlertCircle className="w-8 h-8 text-red-500 flex-shrink-0" />
              <div className="space-y-1">
                <h3 className="text-lg font-bold text-red-500 uppercase tracking-tighter">
                  Protocol Violation
                </h3>
                <p className="text-slate-400 text-sm leading-relaxed">
                  {error}
                </p>
                <button
                  onClick={reset}
                  className="text-indigo-400 font-bold text-[10px] mt-4 uppercase tracking-widest hover:text-indigo-300 transition-colors"
                >
                  Force System Reboot
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="w-full max-w-4xl mt-32 py-12 border-t border-slate-900 grid md:grid-cols-2 gap-12 text-center md:text-left">
        <div className="space-y-4">
          <Terminal className="w-6 h-6 text-indigo-500 mx-auto md:mx-0" />
          <h4 className="text-slate-200 font-bold uppercase text-[10px] tracking-widest">
            Binary Integrity Shield
          </h4>
          <p className="text-[11px] text-slate-500 leading-relaxed font-mono">
            Each cell is verified against a SHA-256 fingerprint during
            extraction. Data corruption within the container is automatically
            detected.
          </p>
        </div>
        <div className="space-y-4">
          <Cpu className="w-6 h-6 text-indigo-500 mx-auto md:mx-0" />
          <h4 className="text-slate-200 font-bold uppercase text-[10px] tracking-widest">
            Parallel Stream Logic
          </h4>
          <p className="text-[11px] text-slate-500 leading-relaxed font-mono">
            Protocol 3.0 scales based on hardware concurrency. High-performance
            devices utilize multi-thread cell forging for 400% faster
            extraction.
          </p>
        </div>
        
        <div className="col-span-full mt-8 pt-8 border-t border-slate-900/50 flex flex-col items-center justify-center space-y-2 text-center">
          <p className="text-slate-400 text-xs font-mono">
            © {new Date().getFullYear()} <span className="text-indigo-400 font-bold">Raj Mitra</span>. All rights reserved.
          </p>
          <p className="text-slate-500 text-[10px] font-mono max-w-lg">
            Creator of HDA - Hive Data Architecture.<br/>
            Licensed under PolyForm Noncommercial 1.0.0. Commercial use requires a commercial license.
          </p>
        </div>
      </footer>
    </div>
  );
};

export default App;

import React, { useState, useRef, useEffect } from "react";
import { AppMode, FileMetadata, ProcessingProgress } from "./types";
import { decodeFromVBook } from "./services/vbookEncoder";
import { generateHDA } from "./services/hdaEncoder";
import {
  User,
  ChevronRight,
  Lock,
  Layers,
  Cpu,
  CheckCircle,
  AlertCircle,
  Download,
  X,
  FolderOpen,
  FilePlus,
  Info,
  Shield,
  Zap,
  Terminal
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn, formatBytes } from "./lib/utils";

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>(AppMode.ENCODE);
  const [files, setFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [results, setResults] = useState<{ blob: Blob; metadata: FileMetadata }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<'none' | 'howItWorks' | 'about'>('none');
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newFiles = Array.from(e.target.files);
      setFiles((prev: File[]) => {
        const existingKeys = new Set(prev.map((f: File) => `${f.name}-${f.size}-${f.lastModified}`));
        const uniqueNewFiles = newFiles.filter((f: File) => !existingKeys.has(`${f.name}-${f.size}-${f.lastModified}`));
        return [...prev, ...uniqueNewFiles];
      });
      setResults([]);
      setError(null);
    }
  };

  const startProcessing = async () => {
    if (files.length === 0) return;

    setIsProcessing(true);
    setResults([]);
    setError(null);

    try {
      if (mode === AppMode.ENCODE) {
        setProgress({
          percentage: 0,
          status: `Initializing...`,
          logs: [`[CORE] Preparing ${files.length} files for encoding`],
        });
        
        const resultData = await generateHDA(files, password || null, (p: ProcessingProgress) => setProgress(p));
        if (resultData) {
          setResults([{
            blob: (resultData as any).blob || new Blob(),
            metadata: resultData,
          }]);
        }
      } else {
        // Decode mode only takes one file at a time
        const file = files[0];
        setProgress({
          percentage: 0,
          status: `Initializing ${file.name}...`,
          logs: [`[CORE] Preparing to decode ${file.name}`],
        });
        
        try {
          const decoded = await decodeFromVBook(file, password || null, (p: ProcessingProgress) => setProgress(p));
          if (decoded) {
            setResults([decoded]);
          }
        } catch (err: any) {
          if (err.message === "ABORTED") {
             setIsProcessing(false);
             setProgress(null);
             return;
          }
          if (err.message === "ENCRYPTED_VOLUME") {
             setError(`File "${file.name}" is encrypted. Please provide the Secret Key and try again.`);
             setIsProcessing(false);
             setProgress(null);
             return;
          }
          throw err;
        }
      }
    } catch (err: any) {
      setError(`Error: ${err.message}`);
      setIsProcessing(false);
      setProgress(null);
      return;
    }

    setIsProcessing(false);
    setProgress(null);
    setFiles([]); // Clear queue after success
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  };

  const handleDownload = (result: { blob: Blob; metadata: FileMetadata }) => {
    if (!result.blob || result.blob.size === 0) return;
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
    setResults([]);
    setError(null);
    setProgress(null);
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  };

  return (
    <div className="min-h-screen flex flex-col relative bg-grid">
      {/* Navbar */}
      <nav className="flex justify-between items-center p-6 max-w-7xl mx-auto w-full relative z-10">
        <div className="text-2xl font-serif text-gold font-bold tracking-widest">HDA VAULT</div>
        <div className="flex gap-4 md:gap-8 text-slate-400 font-medium items-center text-sm md:text-base">
          <button 
            onClick={() => { setMode(AppMode.ENCODE); reset(); }} 
            className={cn("pb-1 transition-all", mode === AppMode.ENCODE ? "text-gold border-b-2 border-gold" : "hover:text-slate-200")}
          >
            Encode
          </button>
          <button 
            onClick={() => { setMode(AppMode.DECODE); reset(); }} 
            className={cn("pb-1 transition-all", mode === AppMode.DECODE ? "text-gold border-b-2 border-gold" : "hover:text-slate-200")}
          >
            Decode
          </button>
          <div className="w-px h-4 bg-white/20 mx-1 md:mx-2"></div>
          <button 
            onClick={() => setActiveModal('howItWorks')}
            className="flex items-center gap-1 md:gap-2 hover:text-gold transition-colors"
          >
            <Info size={16} /> <span className="hidden sm:inline">How it Works</span>
          </button>
        </div>
        <div className="hidden sm:flex gap-4 items-center">
           <div className="w-10 h-10 rounded-full glossy-btn flex items-center justify-center text-slate-300"><User size={20}/></div>
           <button className="glossy-btn-gold px-6 py-2 text-sm font-bold rounded-full">App Version 3</button>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-grow flex flex-col items-center w-full relative z-10 px-4">
        
        {/* Hero Section */}
        <div className="text-center mt-12 md:mt-20 w-full max-w-3xl">
          <h1 className="text-4xl md:text-6xl font-serif text-slate-100 mb-6 tracking-tight">Hive Data Architecture</h1>
          <p className="text-slate-400 text-lg md:text-xl mb-10 leading-relaxed font-light">
            Elevate your data security with bespoke encryption, batch processing, and premium archiving solutions.
          </p>
          
          {results.length === 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <button onClick={() => fileInputRef.current?.click()} className="glossy-btn px-8 py-4 text-lg font-medium flex items-center gap-3 rounded-full w-full sm:w-auto justify-center">
                <FilePlus size={20} /> Select Files
              </button>
              {mode === AppMode.ENCODE && (
                <button onClick={() => folderInputRef.current?.click()} className="glossy-btn px-8 py-4 text-lg font-medium flex items-center gap-3 rounded-full w-full sm:w-auto justify-center">
                  <FolderOpen size={20} /> Select Folder
                </button>
              )}
            </div>
          )}
          <input type="file" multiple className="hidden" ref={fileInputRef} onChange={handleFileSelect} />
          <input type="file" webkitdirectory="" directory="" multiple className="hidden" ref={folderInputRef} onChange={handleFileSelect} />
        </div>

        {/* Error Display */}
        {error && (
          <div className="mt-8 max-w-2xl w-full glass-panel border-red-500/30 p-6 rounded-2xl flex items-start gap-4">
            <AlertCircle className="text-red-400 shrink-0 mt-1" />
            <div className="flex-grow">
              <h4 className="text-red-400 font-medium mb-1">Processing Error</h4>
              <p className="text-red-300/80 text-sm">{error}</p>
            </div>
            <button onClick={() => setError(null)} className="text-slate-500 hover:text-slate-300"><X size={20}/></button>
          </div>
        )}

        {/* Cards Section (Configuration & Queue) */}
        {results.length === 0 && (
          <div className="grid md:grid-cols-3 gap-8 max-w-5xl w-full mx-auto mt-20">
            {/* Card 1: Security */}
            <div className="glass-panel-gold p-8 rounded-3xl text-center relative pt-12 flex flex-col">
               <div className="absolute -top-8 left-1/2 -translate-x-1/2 w-16 h-16 rounded-full glossy-btn-gold flex items-center justify-center border-4 border-[#09090b]">
                 <Lock size={24} />
               </div>
               <h3 className="text-xl font-serif text-gold mb-4">Bespoke Security</h3>
               <p className="text-sm text-slate-400 mb-6 flex-grow">Elevate your privacy with AES-256-GCM encryption for all items.</p>
               <input 
                 type="password" 
                 placeholder="Enter Secret Key..." 
                 value={password} 
                 onChange={(e)=>setPassword(e.target.value)} 
                 className="w-full bg-black/40 border border-white/10 rounded-full px-4 py-3 text-center focus:outline-none focus:border-gold/50 text-slate-200 placeholder:text-slate-600 transition-colors" 
               />
            </div>

            {/* Card 2: Batch Queue */}
            <div className="glass-panel p-8 rounded-3xl text-center relative pt-12 flex flex-col">
               <div className="absolute -top-8 left-1/2 -translate-x-1/2 w-16 h-16 rounded-full glossy-btn flex items-center justify-center border-4 border-[#09090b]">
                 <Layers size={24} />
               </div>
               <h3 className="text-xl font-serif text-slate-200 mb-4">Batch Processing</h3>
               <p className="text-sm text-slate-400 mb-6 flex-grow">Process multiple items at once with infinite scaling.</p>
               <div className="bg-black/40 border border-white/10 rounded-full px-4 py-3 text-slate-300 font-medium">
                 {files.length} {files.length === 1 ? 'Item' : 'Items'} Selected
                 {files.length > 0 && mode === AppMode.ENCODE && (
                   <span className="text-slate-500 text-xs ml-2">
                     (~{formatBytes(files.reduce((acc, f) => acc + f.size, 0) + 1024 * 256)})
                   </span>
                 )}
               </div>
               {files.length > 0 && (
                 <button onClick={() => setFiles([])} className="text-xs text-slate-500 hover:text-slate-300 mt-3 transition-colors">
                   Clear Selection
                 </button>
               )}
            </div>

            {/* Card 3: Execution */}
            <div className="glass-panel p-8 rounded-3xl text-center relative pt-12 flex flex-col">
               <div className="absolute -top-8 left-1/2 -translate-x-1/2 w-16 h-16 rounded-full glossy-btn flex items-center justify-center border-4 border-[#09090b]">
                 <Cpu size={24} />
               </div>
               <h3 className="text-xl font-serif text-slate-200 mb-4">Cloud Innovation</h3>
               <p className="text-sm text-slate-400 mb-6 flex-grow">Stream multi-gigabyte files directly to your local disk.</p>
               <button 
                 onClick={startProcessing} 
                 disabled={files.length === 0 || isProcessing} 
                 className="glossy-btn w-full py-3 rounded-full disabled:opacity-50 font-medium tracking-wide"
               >
                 {isProcessing ? 'Processing...' : 'Start Engine'}
               </button>
            </div>
          </div>
        )}

        {/* Results Section */}
        {results.length > 0 && (
          <div className="w-full max-w-4xl mt-16 space-y-8">
            <h3 className="text-3xl font-serif text-gold text-center mb-8">Processing Complete</h3>
            <div className="grid md:grid-cols-2 gap-6">
              {results.map((res, idx) => (
                <div key={idx} className="glass-panel p-6 rounded-2xl flex flex-col justify-between">
                   <div className="flex items-start justify-between mb-4">
                     <div className="overflow-hidden">
                       <p className="font-medium text-slate-200 truncate text-lg">{res.metadata.name}</p>
                       <p className="text-sm text-slate-500 font-mono">{formatBytes(res.metadata.size)}</p>
                     </div>
                     <CheckCircle className="text-emerald-500 shrink-0" />
                   </div>
                   {res.blob && res.blob.size > 0 ? (
                     <button onClick={() => handleDownload(res)} className="glossy-btn w-full py-3 rounded-full flex items-center justify-center gap-2 font-medium">
                       <Download size={18} /> Download
                     </button>
                   ) : (
                     <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-medium text-center py-3 rounded-full">
                       Saved to Disk
                     </div>
                   )}
                </div>
              ))}
            </div>
            <button onClick={reset} className="glossy-btn-gold w-full max-w-md mx-auto block py-4 rounded-full font-medium text-lg mt-12 text-black">
              Process More Files
            </button>
          </div>
        )}

      </main>

      {/* Processing Modal */}
      {isProcessing && progress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="glass-panel p-8 rounded-3xl w-full max-w-lg shadow-2xl border-white/10 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gold"></div>
            <h3 className="text-2xl font-serif text-slate-200 mb-6 text-center">Processing Vault</h3>
            <div className="h-2 w-full bg-black/50 rounded-full overflow-hidden border border-white/5 mb-4 shadow-inner">
              <div className="h-full bg-gold transition-all duration-300" style={{ width: `${progress.percentage}%` }}></div>
            </div>
            <div className="text-xs text-center text-slate-400 font-medium uppercase tracking-widest mb-6">
              {progress.status}
            </div>
            <div className="bg-black/50 rounded-xl p-4 h-40 overflow-y-auto border border-white/5 font-mono text-[10px] text-slate-400 space-y-1 shadow-inner">
              {progress.logs?.map((log, idx) => (
                <div key={idx}>&gt; {log}</div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Informational Modals */}
      <AnimatePresence>
        {activeModal !== 'none' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md"
            onClick={() => setActiveModal('none')}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="glass-panel p-8 rounded-3xl w-full max-w-2xl shadow-2xl border-white/10 relative overflow-hidden"
            >
              <button 
                onClick={() => setActiveModal('none')} 
                className="absolute top-6 right-6 text-slate-400 hover:text-white transition-colors bg-black/20 p-2 rounded-full"
              >
                <X size={20} />
              </button>

              {activeModal === 'howItWorks' && (
                <div className="space-y-6">
                  <div className="flex items-center gap-4 mb-8">
                    <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                      <Terminal size={24} />
                    </div>
                    <div>
                      <h2 className="text-2xl font-serif text-slate-100">The HDA Protocol</h2>
                      <p className="text-sm text-cyan-400 font-mono">v3.0 Architecture</p>
                    </div>
                  </div>
                  
                  <div className="bg-black/40 border border-white/5 rounded-2xl p-4 mb-6">
                    <h3 className="text-sm font-mono text-slate-400 uppercase tracking-widest mb-3">Live System Status</h3>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-slate-500">Core Count:</span>
                        <span className="ml-2 text-slate-200 font-mono">{navigator.hardwareConcurrency || 'Unknown'} Threads</span>
                      </div>
                      <div>
                        <span className="text-slate-500">FSAA Support:</span>
                        <span className="ml-2 text-emerald-400 font-mono">{'showSaveFilePicker' in window ? 'Enabled' : 'Disabled'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Worker Pool:</span>
                        <span className="ml-2 text-cyan-400 font-mono">{Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, 8))}x Parallel</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Crypto Engine:</span>
                        <span className="ml-2 text-gold font-mono">WebCrypto API</span>
                      </div>
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-gold font-medium">
                        <Shield size={18} /> Military-Grade Security
                      </div>
                      <p className="text-sm text-slate-400 leading-relaxed">
                        Data is encrypted locally in your browser using AES-256-GCM. Your secret keys never leave your device, ensuring zero-knowledge privacy.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-cyan-400 font-medium">
                        <Zap size={18} /> Parallel Processing
                      </div>
                      <p className="text-sm text-slate-400 leading-relaxed">
                        HDA Vault utilizes a multi-threaded Web Worker pool to compress and encrypt massive files simultaneously, utilizing your CPU's full potential.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-emerald-400 font-medium">
                        <Layers size={18} /> Smart Archiving
                      </div>
                      <p className="text-sm text-slate-400 leading-relaxed">
                        Select entire folders or thousands of files. The protocol preserves your exact directory structure into a single, self-extracting HTML payload.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-purple-400 font-medium">
                        <Download size={18} /> Direct-to-Disk Streaming
                      </div>
                      <p className="text-sm text-slate-400 leading-relaxed">
                        Bypasses browser memory limits by streaming decoded data directly to your hard drive using the modern File System Access API.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {activeModal === 'about' && (
                <div className="space-y-6 text-center">
                  <div className="w-24 h-24 rounded-full bg-gold/10 border-2 border-gold/30 flex items-center justify-center text-gold mx-auto mb-6 shadow-[0_0_30px_rgba(212,175,55,0.2)]">
                    <User size={40} />
                  </div>
                  <h2 className="text-3xl font-serif text-slate-100 mb-2">The Visionary Behind HDA</h2>
                  <div className="w-16 h-1 bg-gold mx-auto rounded-full mb-6"></div>
                  <p className="text-slate-300 leading-relaxed text-lg max-w-lg mx-auto">
                    HDA Vault was engineered to redefine how we store, secure, and transmit data on the modern web. 
                  </p>
                  <p className="text-slate-400 leading-relaxed max-w-lg mx-auto mb-8">
                    Frustrated by the limitations of legacy formats like ZIP and RAR, <strong className="text-gold">Raj Mitra</strong> envisioned a protocol built natively for the browser—combining military-grade encryption with multi-threaded performance, all wrapped in a self-extracting, universally accessible format.
                  </p>
                  <div className="bg-black/40 border border-white/5 rounded-2xl p-4 inline-block">
                    <p className="text-sm font-mono text-slate-500 uppercase tracking-widest">Creator & Lead Architect</p>
                    <p className="text-xl font-serif text-gold mt-1">Raj Mitra</p>
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="w-full max-w-7xl mx-auto p-6 mt-20 flex flex-col md:flex-row justify-between items-center text-sm text-slate-600 relative z-10 border-t border-white/5">
        <div className="font-serif text-gold font-bold tracking-widest">HDA VAULT</div>
        <div className="text-center my-4 md:my-0">
          Copyright &copy; {new Date().getFullYear()} Raj Mitra. All rights reserved.
        </div>
        <div>
          <button 
            onClick={() => setActiveModal('about')}
            className="font-medium text-gold hover:text-yellow-300 transition-colors"
          >
            Created by Raj Mitra.
          </button>
        </div>
      </footer>
    </div>
  );
};

export default App;

import React, { useRef, useState, useEffect } from 'react';
import { X, Camera, Image, Sparkles, AlertCircle, RefreshCw } from 'lucide-react';
import { Book } from '../types';

interface ScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBooksScanned: (books: Book[]) => void;
}

export const ScannerModal: React.FC<ScannerModalProps> = ({ isOpen, onClose, onBooksScanned }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [hasCameraAccess, setHasCameraAccess] = useState<boolean | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const [error, setError] = useState('');

  // Declare camera control helper functions at the top of the component
  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const startCamera = async () => {
    setError('');
    setHasCameraAccess(null);
    try {
      // Prefer the rear camera (environment) for spine scanning
      const constraints = {
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setHasCameraAccess(true);
    } catch (err: any) {
      console.warn('Fallback to standard camera constraints due to err:', err);
      try {
        // Try simple video constraint
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setHasCameraAccess(true);
      } catch (fallbackErr) {
        console.error('No camera access:', fallbackErr);
        setHasCameraAccess(false);
      }
    }
  };

  // Convert base64 and call backend Express api
  const processImage = async (base64Image: string) => {
    setIsScanning(true);
    setScanStatus('Enviando foto para a IA...');
    setError('');

    // Rotate standard statuses for premium feels
    const statuses = [
      'Analisando lombadas dos livros...',
      'Identificando títulos e autores...',
      'Buscando sinopses na internet...',
      'Organizando dados da estante...',
    ];
    let statusIdx = 0;
    const interval = setInterval(() => {
      if (statusIdx < statuses.length) {
        setScanStatus(statuses[statusIdx]);
        statusIdx++;
      }
    }, 1500);

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64Image }),
      });

      clearInterval(interval);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Não foi possível processar as lombadas.');
      }

      const data = await response.json();
      if (data.books && data.books.length > 0) {
        onBooksScanned(data.books);
        onClose();
      } else {
        throw new Error('Nenhum livro identificado de forma clara na imagem. Tente uma foto mais aproximada e focada.');
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Falha ao conectar ao servidor de IA.');
    } finally {
      clearInterval(interval);
      setIsScanning(false);
    }
  };

  const captureFrame = () => {
    if (!videoRef.current) return;

    try {
      const video = videoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Draw current video frame to canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const base64Image = canvas.toDataURL('image/jpeg', 0.85);
        processImage(base64Image);
      }
    } catch (err) {
      console.error('Failed to capture video frame:', err);
      setError('Não foi possível capturar o frame do vídeo.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        processImage(reader.result);
      }
    };
    reader.onerror = () => {
      setError('Falha ao ler o arquivo de imagem.');
    };
    reader.readAsDataURL(file);
  };

  // Auto-start video when modal opens (now safe because functions are initialized above)
  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4 bg-slate-950/80 backdrop-blur-md">
      <div
        id="scanner-modal-container"
        className="relative bg-slate-900 w-full sm:max-w-lg h-full sm:h-auto sm:max-h-[90vh] sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden text-white"
      >
        {/* Header */}
        <div className="p-5 flex items-center justify-between border-b border-slate-800 bg-slate-900/90 backdrop-blur z-10">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-bento-purple animate-pulse" />
            <h2 className="font-sans font-bold text-lg">Escanear Lombadas</h2>
          </div>
          <button
            id="btn-close-scanner"
            onClick={onClose}
            disabled={isScanning}
            className="p-1.5 rounded-full hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Camera / Upload Content */}
        <div className="flex-1 relative bg-black flex flex-col justify-center items-center min-h-[50vh] max-h-[70vh]">
          {isScanning ? (
            /* AI Processing / Scanning Overlay */
            <div className="absolute inset-0 bg-slate-950/90 z-20 flex flex-col items-center justify-center p-6 text-center">
              <div className="relative mb-6">
                <div className="w-16 h-16 rounded-full border-4 border-bento-primary/20 border-t-bento-primary animate-spin" />
                <Sparkles className="w-6 h-6 text-bento-purple absolute inset-0 m-auto animate-bounce" />
              </div>
              <h3 className="font-bold text-lg text-white mb-2">Lendo a Estante da Lu</h3>
              <p className="text-bento-purple text-sm font-medium animate-pulse">{scanStatus}</p>
              <p className="text-xs text-slate-500 mt-4 max-w-xs">
                O Gemini 2.5 Flash está analisando sua foto para extrair títulos, autores e sinopses. Isso pode levar alguns segundos.
              </p>
            </div>
          ) : null}

          {/* Error banner */}
          {error && (
            <div className="absolute top-4 left-4 right-4 z-10 bg-rose-950/90 border border-rose-800 text-rose-100 p-4 rounded-2xl flex gap-2.5 items-start text-xs leading-relaxed">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-bold">Houve um imprevisto:</p>
                <p className="opacity-90">{error}</p>
                <button
                  onClick={startCamera}
                  className="mt-2 text-bento-purple font-bold hover:underline flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> Tentar ligar câmera novamente
                </button>
              </div>
            </div>
          )}

          {hasCameraAccess === true ? (
            /* Live Camera view */
            <div className="relative w-full h-full flex justify-center items-center overflow-hidden">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover min-h-[50vh]"
              />

              {/* Scanning visual overlay frame */}
              <div className="absolute inset-0 border-[30px] border-black/40 pointer-events-none flex items-center justify-center">
                <div className="relative w-full max-w-[280px] h-[340px] border-2 border-bento-primary rounded-2xl shadow-[0_0_15px_rgba(121,134,203,0.3)]">
                  {/* Neon corners */}
                  <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-bento-purple rounded-tl-md" />
                  <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-bento-purple rounded-tr-md" />
                  <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-bento-purple rounded-bl-md" />
                  <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-bento-purple rounded-br-md" />

                  {/* Scanning Laser line */}
                  <div className="absolute left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-bento-purple to-transparent shadow-[0_0_8px_#7986cb] animate-[scan_2.5s_ease-in-out_infinite]" />
                </div>
              </div>

              {/* Top Hint */}
              <div className="absolute top-4 bg-black/60 backdrop-blur px-4 py-1.5 rounded-full text-xs font-semibold tracking-wide text-center text-slate-200">
                Aponte para a prateleira ou lombada dos livros
              </div>
            </div>
          ) : (
            /* Fallback Camera / Upload state */
            <div className="p-8 text-center flex flex-col items-center max-w-sm">
              <div className="w-16 h-16 rounded-3xl bg-slate-800 flex items-center justify-center text-slate-400 mb-4 border border-slate-700 shadow-inner">
                <Camera className="w-8 h-8" />
              </div>
              <h3 className="font-bold text-lg text-slate-200 mb-1">Câmera não disponível</h3>
              <p className="text-slate-400 text-sm mb-6 leading-relaxed">
                As permissões da câmera podem estar bloqueadas, ou você está em uma visualização interna. Sem problemas! Você pode tirar uma foto na hora com o celular ou escolher uma imagem salva.
              </p>
            </div>
          )}
        </div>

        {/* Footer controls */}
        <div className="p-5 border-t border-slate-800 bg-slate-900 flex flex-col gap-3">
          <div className="flex gap-3 justify-center items-center w-full">
            {hasCameraAccess && (
              <button
                id="btn-trigger-capture"
                onClick={captureFrame}
                disabled={isScanning}
                className="flex-1 py-3.5 bg-bento-primary hover:bg-bento-primary/90 disabled:opacity-50 text-white rounded-xl text-sm font-semibold transition-all shadow-lg hover:shadow-bento-primary/20 flex items-center justify-center gap-2"
              >
                <Camera className="w-4 h-4" /> Tirar Foto
              </button>
            )}

            <button
              id="btn-upload-file"
              onClick={() => fileInputRef.current?.click()}
              disabled={isScanning}
              className={`py-3.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 ${
                hasCameraAccess
                  ? 'flex-1 border border-slate-700 hover:bg-slate-800 text-slate-300'
                  : 'w-full bg-bento-primary hover:bg-bento-primary/90 text-white shadow-lg shadow-bento-primary/20'
              }`}
            >
              <Image className="w-4 h-4" />
              {hasCameraAccess ? 'Enviar Foto' : 'Tirar Foto ou Escolher Imagem'}
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment" // Auto-opens phone camera if supported
            onChange={handleFileUpload}
            className="hidden"
          />

          <p className="text-[11px] text-slate-500 text-center">
            Dica: Para melhores resultados, garanta boa iluminação e foco direto nas palavras das lombadas.
          </p>
        </div>
      </div>

      {/* Embedded CSS animations for scanning beam */}
      <style>{`
        @keyframes scan {
          0%, 100% { top: 0%; }
          50% { top: 100%; }
        }
      `}</style>
    </div>
  );
};

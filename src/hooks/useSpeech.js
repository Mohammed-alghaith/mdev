import { useEffect, useRef, useState, useCallback } from 'react';

const Recognition =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export function useSpeech({ onFinal, onInterim } = {}) {
  const recognitionRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const supported = !!Recognition;

  useEffect(() => {
    if (!supported) return;
    const r = new Recognition();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';

    r.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim && onInterim) onInterim(interim);
      if (finalText && onFinal) onFinal(finalText);
    };
    r.onerror = (e) => setError(e.error || 'recognition-error');
    r.onend = () => setListening(false);
    recognitionRef.current = r;

    return () => {
      try { r.stop(); } catch {}
      recognitionRef.current = null;
    };
  }, [onFinal, onInterim, supported]);

  const start = useCallback(() => {
    if (!recognitionRef.current) return;
    setError(null);
    try {
      recognitionRef.current.start();
      setListening(true);
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, []);

  const stop = useCallback(() => {
    if (!recognitionRef.current) return;
    try { recognitionRef.current.stop(); } catch {}
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  return { supported, listening, error, start, stop, toggle };
}

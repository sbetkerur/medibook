'use client';
import { useEffect, useRef } from 'react';

export default function Modal({ title, onClose, children, wide }) {
  const overlayRef = useRef();
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2)}`).current;

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
      ref={overlayRef}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`bg-white rounded-2xl shadow-2xl w-full ${wide === 'xl' ? 'max-w-3xl' : wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[92vh] flex flex-col`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 md:px-6 md:py-4 border-b border-gray-100 shrink-0">
          <h2 id={titleId} className="text-base font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1 -mr-1" aria-label="Close">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 md:p-6">{children}</div>
      </div>
    </div>
  );
}

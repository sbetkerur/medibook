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

  // Capped at 85vh on phones (92vh at md): vh ignores the on-screen keyboard, so
  // a taller dialog on a short viewport puts its footer buttons under the keyboard.
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/40 backdrop-blur-sm"
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
      ref={overlayRef}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`bg-white rounded-2xl shadow-2xl w-full ${wide === 'xl' ? 'max-w-3xl' : wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[85vh] md:max-h-[92vh] flex flex-col`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 md:px-6 md:py-4 border-b border-gray-100 shrink-0">
          <h2 id={titleId} className="text-base font-semibold text-gray-900 min-w-0 break-words">{title}</h2>
          {/* 40px hit area on touch; the desktop look (a bare glyph) is restored at md. */}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none shrink-0 w-10 h-10 -mr-2 flex items-center justify-center md:w-auto md:h-auto md:p-1 md:-mr-1" aria-label="Close">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 md:p-6">{children}</div>
      </div>
    </div>
  );
}
